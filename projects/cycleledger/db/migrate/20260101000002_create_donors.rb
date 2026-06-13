# Donors are the individuals making contributions. Synthetic, clearly-fictional
# people only — no real PII. employer/occupation live here as the canonical
# donor attributes; each contribution also snapshots them (FEC reports the
# employer/occupation *as given at the time of the contribution*).
class CreateDonors < ActiveRecord::Migration[7.2]
  def change
    create_table :donors do |t|
      t.string :full_name, null: false
      t.string :city
      t.string :state, limit: 2
      t.string :zip, limit: 10
      t.string :employer
      t.string :occupation
      t.timestamps
    end
    add_index :donors, %i[state city]
  end
end
