class Donor < ApplicationRecord
  has_many :contributions, dependent: :restrict_with_exception

  validates :full_name, presence: true
end
